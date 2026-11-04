/**
 * 清空一个构建输出目录。
 *
 * 为什么需要：`tsc` 只写不删——源文件被删掉（或改名）后，`dist/` 里那份编译产物会
 * 一直留着。2.3.0 实测到过后果：`accounts/classify.ts` 已移除，`server/dist` 里仍有
 * `classify.js`，最后被打进了便携版与安装包。残留文件不会报错，只会悄悄让「发布出去
 * 的东西」与「仓库里的代码」不一致。
 *
 * 用法：`node ../scripts/clean.mjs dist`（在 workspace 目录下运行）
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('[clean] 用法：node scripts/clean.mjs <目录>');
  process.exit(1);
}
rmSync(resolve(target), { recursive: true, force: true });
