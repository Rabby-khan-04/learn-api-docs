// DANGER DEMO ONLY. This server exists so chapter 24 can reproduce mistakes.
// Never copy anything from this file into a real API.
import express from 'express';

const app = express();
app.use(express.json());

const products = [
  { id: 1, tenantId: 'ten_acme', name: 'Classic T-Shirt', price: 19.99, internalCost: 7.1 },
  { id: 2, tenantId: 'ten_acme', name: 'Camp Mug', price: 12.99, internalCost: 4.2 },
  { id: 3, tenantId: 'ten_globex', name: 'EU Camp Mug', price: 11.99, internalCost: 3.9 },
];

app.get('/getProducts', (_req, res) => {
  res.status(200).json({ success: false, error: 'Use /products instead', data: null });
});

app.get('/products', (_req, res) => {
  // BUG: ignores tenant entirely and returns every tenant's rows.
  res.json(products);
});

app.get('/products/:id', (req, res) => {
  const product = products.find((row) => String(row.id) === req.params.id);
  if (!product) {
    res.status(200).json({ success: false, error: 'not found' });
    return;
  }
  // BUG: leaks tenantId, internal cost, and a float price.
  res.json(product);
});

app.get('/orders/:id', (_req, res) => {
  // BUG: 200 with an error body instead of 404.
  res.status(200).json({ ok: false, message: 'Order not found' });
});

app.get('/products-n-plus-one', (_req, res) => {
  const started = Date.now();
  const rows = products.map((product) => {
    // Pretend this is a database query per row.
    console.log(`SELECT * FROM inventory WHERE product_id = ${product.id}`);
    return { ...product, stock: 10 + product.id };
  });
  res.json({ rows, simulatedQueries: rows.length, ms: Date.now() - started });
});

app.listen(4013, () => {
  console.log('mistakes server (DANGER DEMO) listening on http://localhost:4013');
});
