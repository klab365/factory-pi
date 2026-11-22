import { visit } from 'unist-util-visit';

// Keep sibling links valid in GitHub's Markdown view and in the Pages build.
export function remarkDocsLinks({ base }) {
  const prefix = base.replace(/\/$/, '');
  const rewrite = (link) => {
    const match = /^(?:\.\/)?([a-z0-9][a-z0-9-]*)\.md([?#].*)?$/i.exec(link.url);
    if (!match) return;
    const [, slug, suffix = ''] = match;
    link.url = `${prefix}/${slug === 'index' ? '' : `${slug}/`}${suffix}`;
  };

  return (tree) => visit(tree, ['link', 'definition'], rewrite);
}
