import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

// A deliberately small receiver for the webhook chapters. It shows the three
// things every receiver must do: verify the signature, reject stale messages,
// and make duplicate deliveries harmless.
const app = express();
const seen = new Set<string>();
const PORT = Number(process.env.WEBHOOK_RECEIVER_PORT ?? 4020);

app.use(express.raw({ type: 'application/json', limit: '100kb' }));

function verify(secret: string, header: string | undefined, rawBody: Buffer): string | null {
  if (!header) return 'missing signature';
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key ?? '', rest.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!Number.isInteger(timestamp) || !signature) return 'malformed signature';

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > 300) return `timestamp too old (${age}s)`;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  const given = Buffer.from(signature, 'hex');
  const want = Buffer.from(expected, 'hex');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return 'signature mismatch';
  return null;
}

app.post('/hooks/orders', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET ?? 'whsec_learn_acme';
  const problem = verify(secret, req.get('x-webhook-signature'), req.body as Buffer);
  if (problem) {
    console.log(`rejected delivery: ${problem}`);
    res.status(401).json({ error: problem });
    return;
  }

  const event = JSON.parse((req.body as Buffer).toString('utf8')) as {
    id: string;
    type: string;
    data: Record<string, unknown>;
  };
  if (seen.has(event.id)) {
    console.log(`${event.type} ${event.id} duplicate=true`);
    res.status(200).json({ received: true, duplicate: true });
    return;
  }
  seen.add(event.id);
  console.log(`${event.type} ${event.id} duplicate=false data=${JSON.stringify(event.data)}`);
  res.status(200).json({ received: true, duplicate: false });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', deliveredEvents: seen.size });
});

app.listen(PORT, () => {
  console.log(`webhook receiver listening on http://localhost:${PORT}/hooks/orders`);
});
