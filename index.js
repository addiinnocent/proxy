const Koa = require('koa');
const Router = require('@koa/router');
const cors = require('@koa/cors');
const proxyHandler = require('./proxyHandler');
const morgan = require('koa-morgan');

const app = new Koa();
const router = new Router();

proxyHandler.register(router);

//app.use(morgan('dev'));
app.use(cors());
app.use(router.routes()).use(router.allowedMethods());
app.use(morgan('combined', {
  skip: (req, res) => res.statusCode < 405 // Log only if status is 400+
}));

console.log("Registered Routes:", router.stack.map(i => i.path)); // ✅ Log routes

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
