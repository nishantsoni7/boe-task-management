// Restore helper: node decrypt-file.mjs <file.enc> <output>   (uses BOE_BACKUP_PASSPHRASE or the .keys file)
import { decryptFile } from './lib.mjs'

const [src, dest] = process.argv.slice(2)
if (!src || !dest) {
  console.error('usage: node decrypt-file.mjs <file.enc> <output>')
  process.exit(2)
}
decryptFile(src, dest)
console.log('decrypted ->', dest)
