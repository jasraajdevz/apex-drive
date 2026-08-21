// Concatenates src parts into a single self-contained index.html
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'src');
const files = fs.readdirSync(dir).filter(f => /\.(html|css|js)$/.test(f)).sort();
let out = '';
for (const f of files) {
  const body = fs.readFileSync(path.join(dir, f), 'utf8');
  if (f.endsWith('.css')) out += '<style>\n' + body + '\n</style>\n';
  else if (f.endsWith('.js')) out += '<script>\n/* ===== ' + f + ' ===== */\n' + body + '\n</script>\n';
  else out += body + '\n';
}
fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log('built index.html  ' + (out.length / 1024).toFixed(1) + ' KB  from ' + files.length + ' parts');
