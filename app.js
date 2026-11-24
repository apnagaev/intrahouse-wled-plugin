'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PENDING_COMMANDS = 32;

function integer(value, min, max, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^-?\d+$/.test(value.trim()))) {
    throw new Error(label + ': требуется целое число');
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(label + ': допустимый диапазон ' + min + '…' + max);
  }
  return number;
}

function request(endpoint, timeout, payload) {
  const transport = endpoint.protocol === 'https:' ? https : http;
  const body = payload === undefined ? undefined : JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = transport.request(endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      agent: false,
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      if (response.statusCode !== 200) {
        req.destroy(new Error('HTTP ' + response.statusCode));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Ответ WLED прерван')));
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Ответ WLED слишком большой'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error('WLED вернул некорректный JSON'));
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Тайм-аут WLED')), timeout);
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    req.end(body);
  });
}

function power(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error('on: ожидается 0 или 1');
}

function color(value) {
  if (typeof value !== 'string' || !/^#?(?:[\da-f]{6}|[\da-f]{8})$/i.test(value.trim())) {
    throw new Error('color: ожидается #RRGGBB или #RRGGBBWW');
  }
  return value.trim().replace(/^#/, '').match(/../g).map(byte => parseInt(byte, 16));
}

const CATALOG_PATHS = {
  preset: '/presets.json',
  effect: '/json/eff',
  palette: '/json/pal'
};
const CATALOG_TTL = 60000;

function catalogNames(kind, response) {
  const entries = kind === 'preset'
    ? Object.entries(response || {}).filter(([id]) => /^[1-9]\d*$/.test(id) && Number(id) <= 250)
      .map(([id, preset]) => [Number(id), preset && preset.n])
    : Array.isArray(response) ? Object.entries(response).map(([id, name]) => [Number(id), name]) : [];
  return new Map(entries.filter(([, name]) => typeof name === 'string' &&
    name.trim() && name !== '-' && name !== 'RSVD'));
}

const WRITE = {
  on: value => ({ on: power(value) }),
  brightness: value => {
    const percent = integer(value, 0, 100, 'brightness');
    return percent === 0 ? { on: false } : { on: true, bri: Math.round(percent * 255 / 100) };
  },
  preset: value => ({ ps: integer(value, 1, 250, 'preset') }),
  color: (value, id) => ({ seg: [{ id, col: [color(value)] }] }),
  effect: (value, id) => ({ seg: [{ id, fx: integer(value, 0, 255, 'effect') }] }),
  palette: (value, id) => ({ seg: [{ id, pal: integer(value, 0, 255, 'palette') }] })
};

module.exports = function start(plugin, params) {
  const host = String(params.host || '').trim();
  if (!host) throw new Error('укажите IP или имя контроллера в параметрах плагина');
  const endpoint = new URL(host.includes('://') ? host : 'http://' + host);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('ожидается адрес контроллера без пути, логина и пароля');
  }
  endpoint.pathname = '/json/state';
  const interval = 1000 * integer(params.pollSeconds || 5, 1, 300, 'Опрос');
  const timeout = integer(params.timeout || 2500, 250, 15000, 'Тайм-аут');
  const configuredSegment = integer(params.segment == null || params.segment === '' ? -1 : params.segment, -1, 255, 'Сегмент');

  let state;
  let refreshAt = 0;
  let refreshInFlight;
  const catalogs = new Map();
  const channelIds = new Map();
  function updateChannels(channels) {
    if (!Array.isArray(channels)) return;
    channelIds.clear();
    for (const channel of channels) {
      if (channel.chan && channel.id) channelIds.set(channel.chan, channel.id);
    }
  }

  function refreshCatalogs() {
    if (refreshInFlight) return refreshInFlight;
    refreshAt = Date.now() + CATALOG_TTL;
    refreshInFlight = (async () => {
      for (const [kind, pathname] of Object.entries(CATALOG_PATHS)) {
        try {
          const response = await request(new URL(pathname, endpoint), timeout);
          catalogs.set(kind, catalogNames(kind, response));
        } catch (error) {
          plugin.log('Справочник WLED ' + kind + ': ' + error.message);
        }
      }
      if (state) publishNames();
    })().finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }

  function publishNames() {
    const segment = selectedSegment();
    const ids = { preset: state.ps, effect: segment && segment.fx, palette: segment && segment.pal };
    publish(Object.fromEntries(Object.entries(ids).map(([kind, id]) => [
      kind + '_name',
      !Number.isInteger(id) || id < 0 ? '' : (catalogs.get(kind)?.get(id) || String(id))
    ])));
  }

  function findCatalogId(kind, value) {
    const names = catalogs.get(kind);
    const query = String(value).trim().normalize('NFC');
    if (!names || !query) return;
    const entries = [...names];
    const exact = entries.filter(([, name]) => name.trim().normalize('NFC') === query);
    const matches = exact.length ? exact : entries.filter(([, name]) =>
      name.trim().normalize('NFC').toLowerCase() === query.toLowerCase());
    if (matches.length > 1) throw new Error('несколько совпадений, укажите ID с префиксом #');
    return matches.length ? matches[0][0] : undefined;
  }

  async function resolveName(kind, value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('введите название или ID');
    if (!catalogs.has(kind) && Date.now() >= refreshAt) await refreshCatalogs();
    else if (refreshInFlight) await refreshInFlight;
    const query = value.trim();
    if (/^#\d+$/.test(query)) return query.slice(1);
    const id = findCatalogId(kind, query);
    if (id !== undefined) return id;
    if (/^\d+$/.test(value.trim())) return value;
    throw new Error('название отсутствует в справочнике WLED: ' + value);
  }
  let online;
  let busy = false;
  const commands = [];
  let queueWarning = false;

  function selectedSegment() {
    const id = configuredSegment === -1 ? state.mainseg : configuredSegment;
    return state.seg.find(segment => segment.id === id) ||
      (configuredSegment === -1 ? state.seg[0] : undefined);
  }

  function publish(values) {
    const ts = Date.now();
    const data = Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([id, value]) => ({ id: channelIds.get(id) || id, value, ts }));
    plugin.sendData(data);
  }

  function accept(response) {
    const next = response && (response.state || response);
    if (!next || typeof next.on !== 'boolean' || !Number.isInteger(next.bri) || !Array.isArray(next.seg)) {
      throw new Error('Ответ не содержит состояния WLED');
    }
    state = next;
    const segment = selectedSegment();
    const rgb = segment && segment.col && segment.col[0];
    const validColor = Array.isArray(rgb) && (rgb.length === 3 || rgb.length === 4) &&
      rgb.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
    const hex = validColor ? '#' + Buffer.from(rgb).toString('hex').toUpperCase() : undefined;
    if (online !== true) plugin.log('Связь с WLED установлена');
    online = true;
    publish({
      online: 1,
      on: Number(state.on),
      brightness: state.on ? Math.max(1, Math.round(state.bri * 100 / 255)) : 0,
      preset: Number.isInteger(state.ps) ? state.ps : undefined,
      segment_available: Number(Boolean(segment)),
      color: hex,
      effect: segment && segment.fx,
      palette: segment && segment.pal
    });
    publishNames();
    if (Date.now() >= refreshAt) refreshCatalogs();
  }

  async function exchange(payload) {
    try {
      const response = await request(endpoint, timeout, payload);
      if (payload && response && response.success === true) {
        accept(await request(endpoint, timeout));
      } else {
        accept(response);
      }
      return true;
    } catch (error) {
      if (online !== false) refreshAt = 0;
      if (online !== false) plugin.log('Связь с WLED: ' + error.message);
      state = undefined;
      online = false;
      publish({ online: 0, segment_available: 0 });
      return false;
    }
  }

  async function run() {
    if (busy) return;
    busy = true;
    try {
      if (!commands.length) await exchange();
      while (commands.length) {
        const { id: channel, value } = commands.shift();
        const byName = channel.endsWith('_name');
        const id = byName ? channel.slice(0, -5) : channel;
        queueWarning = false;
        let payload;
        try {
          const commandValue = byName ? await resolveName(id, value) : value;
          if (id === 'color' || id === 'effect' || id === 'palette') {
            if (!state && !await exchange()) continue;
            const segment = selectedSegment();
            if (!segment || !Number.isInteger(segment.id)) throw new Error('выбранный сегмент отсутствует в WLED');
            payload = WRITE[id](commandValue, segment.id);
          } else {
            payload = WRITE[id](commandValue);
          }
        } catch (error) {
          plugin.log('Команда ' + id + ' отклонена: ' + error.message);
          continue;
        }
        if (!await exchange({ ...payload, v: true })) {
          plugin.log('Команда ' + id + ': результат не подтверждён');
        }
      }
    } finally {
      busy = false;
    }
  }

  function tick() {
    run().catch(error => plugin.log('Обработка WLED: ' + error.message));
  }

  plugin.onAct(message => {
    for (const command of message.data || []) {
      const id = command.chan || [...channelIds].find(([, channelId]) => channelId === command.id)?.[0] || command.id;
      if (typeof id !== 'string' || (!Object.prototype.hasOwnProperty.call(WRITE, id) &&
          !(id.endsWith('_name') && Object.prototype.hasOwnProperty.call(CATALOG_PATHS, id.slice(0, -5))))) continue;
      if (commands.length < MAX_PENDING_COMMANDS) {
        commands.push({ id, value: command.value });
      } else if (!queueWarning) {
        queueWarning = true;
        plugin.log('Очередь WLED заполнена, новые команды пропущены');
      }
    }
    if (commands.length) tick();
  });

  if (plugin.channels) {
    const loadChannels = () => Promise.resolve(plugin.channels.get()).then(updateChannels)
      .catch(error => plugin.log('Каналы WLED: ' + error.message));
    if (typeof plugin.onChange === 'function') plugin.onChange('channels', loadChannels);
    loadChannels().then(tick);
  } else {
    tick();
  }
  const timer = setInterval(tick, interval);
  return () => clearInterval(timer);
};
