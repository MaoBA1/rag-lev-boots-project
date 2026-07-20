import { LoadedDoc } from './types';

export const ARTICLE_IDS = [
  'military-deployment-report',
  'urban-commuting',
  'hover-polo',
  'warehousing',
  'consumer-safety',
];

const GIST_BASE =
  'https://gist.githubusercontent.com/JonaCodes/394d01021d1be03c9fe98cd9696f5cf3/raw';

export const loadArticles = async (): Promise<LoadedDoc[]> => {
  const docs: LoadedDoc[] = [];

  for (let i = 0; i < ARTICLE_IDS.length; i++) {
    const articleId = ARTICLE_IDS[i];
    const url = `${GIST_BASE}/article-${i + 1}_${articleId}.md`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch article "${articleId}": ${res.status}`);
    }
    const text = await res.text();

    docs.push({ source: 'article', source_id: articleId, text });
  }

  return docs;
};

export const loadArticleById = async (articleId: string): Promise<string> => {
  const index = ARTICLE_IDS.indexOf(articleId);
  if (index === -1) {
    throw new Error(`Unknown article id: "${articleId}"`);
  }

  const url = `${GIST_BASE}/article-${index + 1}_${articleId}.md`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch article "${articleId}": ${res.status}`);
  }

  return res.text();
};
