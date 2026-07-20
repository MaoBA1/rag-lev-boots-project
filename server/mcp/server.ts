import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import ragSearch from './tools/ragSearch';
import listKnowledgeSources from './tools/listKnowledgeSources';
import readSource from './tools/readSource';

const mcpServer = new McpServer({
  name: 'lev-boot-mcp',
  version: '1.0.0',
});

mcpServer.registerTool(
  'rag_search',
  {
    title: 'Rag Search',
    description:
      'Answer a question about Lev-Boots using the internal knowledge base (PDFs, articles, Slack discussions). Grounded in retrieved content only; says so if nothing relevant is found.',
    inputSchema: { question: z.string() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
  },
  ({ question }) => ragSearch(question)
);

mcpServer.registerTool(
  'list_knowledge_sources',
  {
    title: 'List Knowledge Sources',
    description:
      'List every PDF and article source in the Lev-Boots knowledge base, grouped by type (pdf, article)',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  () => listKnowledgeSources()
);

mcpServer.registerTool(
  'read_source',
  {
    title: 'Read Source',
    description:
      'Get the raw text content of one specific PDF or article from the Lev-Boots knowledge base, by name.',
    inputSchema: {
      sourceName: z.string(),
      sourceType: z.enum(['pdf', 'article']).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  ({ sourceName, sourceType }) => readSource(sourceName, sourceType)
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
