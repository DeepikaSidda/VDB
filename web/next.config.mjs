/** @type {import('next').NextConfig} */
const nextConfig = {
  // The web app consumes the backend engine as a built library located at the
  // repository root (../dist/src/**). `externalDir` lets Next bundle modules
  // that live outside this app's directory. In a production deployment the
  // backend would instead be published as a versioned package and imported by
  // name; this relative import keeps the hackathon slice a single repo.
  experimental: {
    externalDir: true,
    // pdf-parse (and its heavy pdfjs-dist engine) must not be bundled by
    // webpack — it is required at runtime from node_modules. Marking it
    // external lets the document path's `import('pdf-parse')` resolve the real
    // module on the server instead of failing with "Cannot find module".
    serverComponentsExternalPackages: ['pdf-parse', 'pdfjs-dist'],
  },
};

export default nextConfig;
