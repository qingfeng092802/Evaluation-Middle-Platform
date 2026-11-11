/**
 * ESLint 9 flat config。
 *
 * 三件事在这里落地：
 *  1. **分层边界**（`technical-solution.md` §3.7）：`app`/`worker` → `lib` → `db` → `contracts`
 *     单向。`lib/operators` 额外禁止 import `db`（算子必须是纯函数）。
 *  2. **AS-1 / AS-2**（`DESIGN.md` §7.1）：禁止裸 `#hex`、内联 `style`、渐变。
 *  3. **离线约束**（`工程规则` §9）：禁止 `next/font/google`、CDN 资源、`lucide/dist` 深引。
 *
 * `globals.css` 与 `tailwind.config.ts` 是唯一豁免：前者是 Token 的归宿，
 * 后者按 `hsl(var(--…))` 写法本身不含 hex。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

/** AS-2 的 AST 层拦截。文本层的补集在 `scripts/check-tokens.mjs`。 */
const STYLE_RULES = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
      message: 'AS-2：禁止裸写 #hex，请用语义 Token（如 bg-eval-pass-bg）',
    },
    {
      // Tailwind 任意值写法 `text-[#fff]` / `bg-[#ff0000]`：整个字面量不是纯 hex，
      // 上一条匹配不到，但它在视觉上完全等价于裸写色值，必须同样拦下。
      selector: 'Literal[value=/\\[#[0-9a-fA-F]{3,8}\\]/]',
      message: 'AS-2：禁止在任意值里写 #hex，请用语义 Token（如 text-eval-pass）',
    },
    {
      selector: 'JSXAttribute[name.name="style"]',
      message: 'AS-2：禁止内联样式，颜色与间距一律走 Token / Tailwind 类',
    },
    {
      selector: 'Literal[value=/(linear|radial|conic)-gradient/]',
      message: 'AS-1：禁止渐变背景',
    },
    {
      selector: 'TemplateElement[value.raw=/(linear|radial|conic)-gradient/]',
      message: 'AS-1：禁止渐变背景',
    },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: 'next/font/google',
          message: '项目规则 §9：禁用 next/font/google（构建期联网）。请用 next/font/local 或 @fontsource。',
        },
      ],
      patterns: [
        {
          group: ['lucide/dist/*', 'lucide-react/dist/*'],
          message: '禁止深引 lucide 内部路径：图标名跨大版本会改，请从 lucide-react 顶层导入。',
        },
        {
          group: ['**/cdns/**'],
          message: '项目规则 §9：禁止任何 CDN 资源。',
        },
      ],
    },
  ],
};

/**
 * 分层边界的公共解析设置。
 *
 * **必须所有 `import/no-restricted-paths` 块都带上**：本仓库内部导入一律写 `.js` 后缀
 * （ESM/Node 要求），而磁盘上是 `.ts`。没有 typescript resolver 时
 * `import/no-restricted-paths` 解析不到目标文件，于是**静默不报**——
 * 那就是一条看着存在、实际从不生效的门禁。
 */
const IMPORT_SETTINGS = {
  'import/resolver': {
    typescript: { project: './tsconfig.json' },
    node: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
  },
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'contracts/**',
      'coverage/**',
      'next-env.d.ts',
      'tsconfig.tsbuildinfo',
      // CSS 由 stylelint 管（`color-no-hex` + `globals.css` 白名单），ESLint 不解析 CSS
      '**/*.css',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        // Web
        document: 'readonly',
        window: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        KeyboardEvent: 'readonly',
        // React JSX 由 tsconfig 处理
        React: 'readonly',
      },
    },
    rules: {
      ...STYLE_RULES,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // 严禁空 catch 吞异常：至少留一行 console 或在注释里说明为什么可以忽略
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
    },
  },

  // ---- 分层边界：lib 不得 import app / worker ----
  {
    files: ['lib/**/*.ts', 'lib/**/*.tsx'],
    plugins: { import: importPlugin },
    settings: IMPORT_SETTINGS,
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './lib', from: './app', message: '分层：lib 不得依赖 app。' },
            { target: './lib', from: './worker', message: '分层：lib 不得依赖 worker。' },
            { target: './lib/operators', from: './db', message: '算子必须是纯函数，不得 import db。' },
            { target: './lib/operators', from: './app', message: '算子不得依赖 app。' },
          ],
        },
      ],
    },
  },

  // ---- 分层边界：db 不得 import lib / app / worker ----
  {
    files: ['db/**/*.ts'],
    plugins: { import: importPlugin },
    settings: IMPORT_SETTINGS,
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './db', from: './app', message: '分层：db 不得依赖 app。' },
            { target: './db', from: './lib', message: '分层：db 不得依赖 lib（依赖单向 db → contracts）。' },
            { target: './db', from: './worker', message: '分层：db 不得依赖 worker。' },
          ],
        },
      ],
    },
  },

  // ---- contracts 必须自洽：只允许依赖 zod ----
  {
    files: ['contracts/**/*.ts'],
    plugins: { import: importPlugin },
    settings: IMPORT_SETTINGS,
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './contracts/src', from: './app', message: '契约不得依赖 app。' },
            { target: './contracts/src', from: './db', message: '契约不得依赖 db。' },
            { target: './contracts/src', from: './lib', message: '契约不得依赖 lib。' },
            { target: './contracts/src', from: './worker', message: '契约不得依赖 worker。' },
          ],
        },
      ],
    },
  },

  // ---- Token 的合法归宿：豁免着色规则 ----
  {
    files: ['app/globals.css'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // ---- 测试与脚本：允许更松的写法 ----
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.mjs', 'tools/**/*.ts', '**/*.spec.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'import/no-unresolved': 'off',
      // 测试夹具必须能写出「违规样本」（`lint-gate.spec.ts` 就是靠写 #ff0000 / gradient 来验证门禁）。
      // 业务组件（app/、components/）不受此豁免影响 —— DoD 要求的是「组件里写 hex 会红」。
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
