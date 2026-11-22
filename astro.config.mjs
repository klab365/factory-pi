import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { remarkDocsLinks } from './docs/site/remark-docs-links.mjs';

const base = '/factory-pi';

export default defineConfig({
  site: 'https://klab365.github.io',
  base,
  trailingSlash: 'always',
  markdown: { processor: unified({ remarkPlugins: [[remarkDocsLinks, { base }]] }) },
  srcDir: './docs/site',
  publicDir: './docs/site/public',
  outDir: './dist/docs',
  integrations: [
    starlight({
      title: 'Factory for Pi',
      defaultLocale: 'root',
      locales: { root: { label: 'English', lang: 'en' } },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/klab365/factory-pi' }],
      sidebar: [
        { label: 'Home', slug: 'index' },
        'guide',
        'syntax',
        'architecture',
      ],
    }),
  ],
});
