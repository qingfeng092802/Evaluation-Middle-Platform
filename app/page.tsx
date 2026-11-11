import { redirect } from 'next/navigation';

/**
 * 根路径重定向到评测运行台（`pages-and-flows.md` §0.3：默认落地页是 `PG-01`）。
 *
 * 在服务端 `redirect` 而不是渲染一个「请点击进入」的页面：
 * 这里没有任何用户可选的信息，多一次点击只是多一次摩擦。
 */
export default function HomePage(): never {
  redirect('/runs');
}
