import type { NextConfig } from 'next';

/**
 * Next 15 配置。
 *
 * `outputFileTracingRoot`：仓库根是 `src/`，而 `contracts` 是 npm workspace。
 * 不显式指定时 Next 会以「最近的 lockfile 所在目录」为根，在有父级 lockfile 的机器上
 * 会追踪到错误目录，导致 standalone 产物缺文件。
 *
 * 刻意**不**配置 `images.remotePatterns`：全站零外部资源（`工程规则` §9），
 * 一旦有人加外链图片，`next/image` 会直接报错而不是悄悄联网。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // 契约包是 TS 源码直出（`main: ./src/index.ts`），需要 Next 参与编译
    externalDir: true,
  },
  webpack: (config) => {
    // 本仓库内部导入一律带 `.js` 后缀（ESM/Node 的写法，磁盘上是 `.ts`）。
    // vitest（vite）原生支持这层映射，webpack 不支持：`contracts/src/index.ts`
    // 里的 `export * from './common.js'` 会直接 `Module not found`，
    // 表现为所有 API 路由 500（`[INT-01]` 首次端到端真栈联调暴露）。
    // `extensionAlias` 就是官方的 `.js → .ts` 映射开关。
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
  eslint: {
    // lint 由 `npm run lint` 单独跑（CI 里是独立门禁），不重复在 `next build` 里跑一遍
    ignoreDuringBuilds: true,
  },
  typescript: {
    // 同上：`npm run typecheck` 是独立门禁
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
