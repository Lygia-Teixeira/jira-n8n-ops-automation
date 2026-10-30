'use strict';
// Ponto de entrada para uso fora do n8n (testes, CLI, outro orquestrador).
module.exports = {
  ...require('./validators'),
  ...require('./text'),
  ...require('./inventory'),
  ...require('./config'),
  ...require('./classify'),
  ...require('./approval'),
  ...require('./catalog'),
  ...require('./password'),
  ...require('./audit'),
  ...require('./jira'),
  ...require('./plan'),
  ...require('./result'),
  ...require('./ssl'),
  ...require('./news'),
};
