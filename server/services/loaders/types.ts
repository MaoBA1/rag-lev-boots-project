export interface LoadedDoc {
  source: 'pdf' | 'article' | 'slack';
  source_id: string;
  text: string;
}
