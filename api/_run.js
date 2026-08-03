'use strict';

const { handleApi } = require('../lib/core');

module.exports = function run(pathname) {
  return function apiHandler(req, res) {
    return handleApi(req, res, pathname).catch((err) => {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message || '请求错误' }));
    });
  };
};
