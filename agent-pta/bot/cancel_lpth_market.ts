import { IBApi, EventName } from '@stoqey/ib';

const ib = new IBApi({
  host: process.env.IB_GATEWAY_HOST || '10.20.0.23',
  port: parseInt(process.env.IB_GATEWAY_PORT || '4002'),
  clientId: 999,
});

ib.on(EventName.connected, () => {
  console.log('Connected to IB Gateway.');
  console.log('Cancelling order ID 3...');
  ib.cancelOrder(3);
  setTimeout(() => {
    console.log('Done, disconnecting...');
    ib.disconnect();
    process.exit(0);
  }, 2000);
});

ib.on(EventName.error, (err, code, reqId) => {
  console.error('IBKR Error:', code, err);
});

ib.connect();
