import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const src = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
const dst = path.join(process.env.USERPROFILE, '.openmausbot', 'bin', 'agy-pinned.exe');

const buf = Buffer.from(fs.readFileSync(src));
let patchedCount = 0;
for (let i = 0; i + 19 <= buf.length; i++) {
  if (buf[i] === 0x48 && buf[i+1] === 0x85 && buf[i+2] === 0xc0 &&
      buf[i+3] === 0x0f && buf[i+4] === 0x84 &&
      buf[i+13] === 0x0f && buf[i+14] === 0x85) {
    if (buf[i+9] === 0x80 && buf[i+10] === 0x78 && buf[i+11] === 0x08 && buf[i+12] === 0x00) {
      buf[i+9] = 0x48;
      buf[i+10] = 0x85;
      buf[i+11] = 0xc0;
      buf[i+12] = 0x90;
      patchedCount++;
    }
  }
}
if (patchedCount !== 2) {
  throw new Error(`Expected 2 patch locations, found ${patchedCount}`);
}

try {
  execSync(`attrib -r "${dst}"`, { stdio: 'ignore' });
} catch {}

fs.writeFileSync(dst, buf);
console.log(`Successfully patched ${patchedCount} locations and wrote to ${dst}`);
