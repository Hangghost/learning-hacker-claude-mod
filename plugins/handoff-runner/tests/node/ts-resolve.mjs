// Node 載入器：讓 hooks/*.ts 裡不帶副檔名的相對 import（引擎的寫法）在 Node 下也找得到。
export async function resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const ext of ['.ts', '/index.d.ts']) {
      try {
        return await next(specifier + ext, context)
      } catch {}
    }
  }
  return next(specifier, context)
}
