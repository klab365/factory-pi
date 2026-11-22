import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { defineCollection } from 'astro:content';

export const collections = {
  docs: defineCollection({
    loader: glob({ base: './docs', pattern: '*.md' }),
    schema: docsSchema(),
  }),
};
