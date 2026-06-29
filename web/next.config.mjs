import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The web app consumes the backend engine as a built library located at the
  // repository root (../dist/src/**). `externalDir` lets Next bundle modules
  // that live outside this app's directory. In a production deployment the
  // backend would instead be published as a versioned package and imported by
  // name; this relative import keeps the hackathon slice a single repo.
  experimental: {
    externalDir: true,
    // Native/dynamic-import server libraries must not be bundled by webpack —
    // they are required at runtime from node_modules. This fixes "Module not
    // found" build errors for the engine's dynamic imports.
    serverComponentsExternalPackages: [
      'pdf-parse',
      'pdfjs-dist',
      'pg',
      'mysql2',
      '@aws-sdk/client-bedrock-runtime',
    ],
  },
  webpack: (config) => {
    // The engine's compiled JS lives at <repo>/dist/src and statically imports
    // packages such as `xlsx`. When Vercel builds with rootDirectory=web only
    // web/node_modules is installed, so webpack must also look there to resolve
    // the engine's dependencies (default resolution would walk up from
    // <repo>/dist/src and miss web/node_modules).
    config.resolve.modules = config.resolve.modules || [];
    config.resolve.modules.push(path.join(process.cwd(), 'node_modules'));
    return config;
  },
};

export default nextConfig;
