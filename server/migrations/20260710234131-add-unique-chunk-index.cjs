'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX knowledge_base_source_source_id_chunk_index_idx
      ON knowledge_base (source, source_id, chunk_index);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS knowledge_base_source_source_id_chunk_index_idx;
    `);
  },
};
