import { createInterface } from 'node:readline/promises';
import bcrypt from 'bcryptjs';

/**
 * Генерирует bcrypt-хэш пароля инстанса для POLARIS_PASSWORD_HASH.
 *   npm run hash-password -- "мой пароль"
 * Без аргумента пароль читается со стандартного ввода (не попадает в историю команд).
 */
async function main() {
  let password = process.argv[2];
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    password = await rl.question('Пароль: ');
    rl.close();
  }
  if (!password || password.length < 8) {
    console.error('Пароль должен быть не короче 8 символов.');
    process.exit(1);
  }
  console.log(bcrypt.hashSync(password, 12));
  console.error('\nСкопируйте строку выше в переменную POLARIS_PASSWORD_HASH (в Render — как есть, без кавычек).');
}

void main();
