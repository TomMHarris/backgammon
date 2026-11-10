// Next.js configuration. The app is exported as plain static files
// ("output: export"): there is no server-side code; all computation happens
// in the browser (the gnubg engine runs in a Web Worker).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
};
export default nextConfig;
