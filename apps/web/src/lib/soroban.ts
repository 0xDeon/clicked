// Lightweight Soroban + Freighter helper for token_transfer calls
// Expects the following env vars (optional):
// - NEXT_PUBLIC_SOROBAN_RPC_URL
// - NEXT_PUBLIC_NETWORK_PASSPHRASE
// - NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT

export async function transferToken(
  recipient: string,
  amount: number | string,
  memo = '',
): Promise<string> {
  const freighter = await import('@stellar/freighter-api');
  const stellar = await import('stellar-sdk');

  const { SorobanRpc, xdr, TransactionBuilder, BASE_FEE, Contract, Networks, nativeToScVal } =
    stellar;

  const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
  const CONTRACT_ID =
    process.env.NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT || 'REPLACE_WITH_TOKEN_TRANSFER_CONTRACT_ID';

  const connectionStatus = await freighter.isConnected();
  if (!connectionStatus.isConnected) {
    throw new Error('Freighter not installed or not connected');
  }

  const { address: publicKey, error: addressError } = await freighter.getAddress();
  if (addressError || !publicKey) {
    throw new Error('Unable to read Freighter wallet address');
  }

  const contract = new Contract(CONTRACT_ID);

  const fromSc = nativeToScVal(publicKey, { type: 'address' });
  const toSc = nativeToScVal(recipient, { type: 'address' });
  const amountBigInt = BigInt(String(amount));
  const amountSc = nativeToScVal(amountBigInt, { type: 'i128' });
  const memoSc = xdr.ScVal.scvSymbol(String(memo || ''));

  const op = contract.call('transfer', fromSc, toSc, amountSc, memoSc);

  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const account = await server.getAccount(publicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(String(simResult.error));
  }

  const prepared = SorobanRpc.assembleTransaction(tx, simResult).build();
  const txXdr = prepared.toXDR();

  const signResult = await freighter.signTransaction(txXdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  if (signResult.error || !signResult.signedTxXdr) {
    throw new Error('Unable to sign transaction with Freighter');
  }

  const { Transaction } = stellar;
  const signedTx = new Transaction(signResult.signedTxXdr, NETWORK_PASSPHRASE);
  const sendResult = await server.sendTransaction(signedTx);

  if (sendResult.status === 'ERROR') {
    throw new Error(`Transaction failed: ${String(sendResult.errorResult || sendResult)}`);
  }

  const hash = sendResult.hash;

  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return hash;
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction reverted: ${hash}`);
      }
    } catch {
      // keep polling until timeout
    }
  }

  throw new Error(`Transaction not confirmed after timeout: ${hash}`);
}

export default transferToken;
