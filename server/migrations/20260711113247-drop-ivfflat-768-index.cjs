'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS knowledge_base_768_cosine_idx;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX knowledge_base_768_cosine_idx
      ON knowledge_base USING ivfflat (embeddings_768 vector_cosine_ops)
      WITH (lists = 100);
    `);
  },
};
