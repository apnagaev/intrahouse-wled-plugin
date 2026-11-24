'use strict';

const fs = require('fs');
const path = require('path');

function main() {
  const [project, device, ...rest] = process.argv.slice(2);
  if (!project || rest.length || (device && !/^d[0-9]+$/.test(device))) {
    throw new Error('Использование: node extras/install.js <каталог проекта> [ID устройства dNNNN]');
  }

  const root = fs.realpathSync(project);
  const jbase = path.join(root, 'jbase');
  const pending = [];
  const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
  const dialog = read('dialog.json');
  const type = read('type.json');

  function db(name) {
    const file = path.join(jbase, name);
    const content = fs.readFileSync(file, 'utf8');
    return {file, content, rows: content.split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)};
  }

  function append(database, rows) {
    if (!rows.length) return;
    const separator = !database.content || database.content.endsWith('\n') ? '' : '\n';
    pending.push([database.file, database.content + separator + rows.map(row => JSON.stringify(row)).join('\n') + '\n']);
  }

  function allocate(rows, prefix) {
    const used = new Set(rows.flatMap(row => [row._id, row.id]));
    for (let n = 1; n < 100000; n++) {
      const id = prefix + String(n).padStart(3, '0');
      if (!used.has(id)) return id;
    }
    throw new Error('Свободный ID не найден: ' + prefix);
  }

  function asset(file, content) {
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(Buffer.from(content))) {
        throw new Error('Файл уже существует: ' + file);
      }
      return;
    }
    pending.push([file, content]);
  }

  const types = db('types.db');
  if (!types.rows.some(row => row._id === type.parent)) throw new Error('Не найден корень типов устройств');
  const existingType = types.rows.find(row => row.name === type.name && row.parent === type.parent && !row.folder);
  const typeId = existingType ? existingType._id : allocate(types.rows, 't');
  if (!existingType) append(types, [{...type, _id: typeId}]);

  const images = db('images.db');
  const imageRoot = images.rows.find(row => row._id === 'imagegroup' && (row.folder || row.parent === 0));
  if (!imageRoot) throw new Error('Не найден корень изображений imagegroup');
  const newImages = [];
  for (const name of fs.readdirSync(path.join(__dirname, 'images')).sort()) {
    if (!/^[a-z0-9-]+\.svg$/.test(name)) throw new Error('Недопустимое имя изображения: ' + name);
    const content = fs.readFileSync(path.join(__dirname, 'images', name));
    asset(path.join(root, 'images', name), content);
    if (!images.rows.some(row => row._id === name || row.name === name)) {
      newImages.push({_id: name, parent: imageRoot._id, title: name, name, order: 90000 + newImages.length * 100});
    }
  }
  append(images, newImages);

  let dialogId;
  if (device) {
    const target = db('devices.db').rows.find(row => row._id === device && !row.folder);
    if (!target) throw new Error('Устройство не найдено: ' + device);
    if (target.type !== typeId) throw new Error('Устройство должно иметь установленный тип ' + typeId);
    const dialogs = db('dialogs.db');
    if (!dialogs.rows.some(row => row._id === 'dialoggroup')) throw new Error('Не найден корень диалогов');
    const name = type.name + ' · ' + device;
    const existing = dialogs.rows.find(row => row.name === name && row.parent === 'dialoggroup' && !row.folder);
    dialogId = existing ? existing._id : allocate(dialogs.rows, 'di');
    const content = JSON.stringify(dialog).replace(/__DEVICE_ID__/g, device) + '\n';
    asset(path.join(jbase, 'dialog', dialogId + '.json'), content);
    if (!existing) append(dialogs, [{_id: dialogId, parent: 'dialoggroup', name, order: 90000, status: 0, miss: 1}]);
  }

  const staged = [];
  try {
    for (const [file, content] of pending) {
      const tmp = file + '.plugin-install-' + process.pid;
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      fs.writeFileSync(tmp, content, {flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o644});
      staged.push([file, tmp]);
      if (stat && typeof process.getuid === 'function' && process.getuid() === 0) {
        fs.chownSync(tmp, stat.uid, stat.gid);
      }
    }
    for (const [file, tmp] of staged) fs.renameSync(tmp, file);
  } finally {
    for (const [, tmp] of staged) if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  console.log('Тип устройства:', typeId);
  if (dialogId) console.log('Диалог:', dialogId);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
