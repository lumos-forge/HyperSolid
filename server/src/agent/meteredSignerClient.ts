import { SignerClient, type ProvisionKeyRequest, type ProvisionKeyResult, type SignRequest, type SignResult, type ReconcileStatus } from "./signerClient";
import { observeSignerRequest } from "../obs/metrics";

/**
 * SignerClient that records op count + duration for each delegated request. Subclass (not a wrapper
 * object) because SignerClient has private fields → only a real subclass is assignable to the
 * SignerClient type consumed across the engine. Records-then-rethrows so errors still propagate.
 */
export class MeteredSignerClient extends SignerClient {
  private async timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const out = await fn();
      observeSignerRequest(op, "ok", (Date.now() - start) / 1000);
      return out;
    } catch (e) {
      observeSignerRequest(op, "error", (Date.now() - start) / 1000);
      throw e;
    }
  }

  override createKey(req: ProvisionKeyRequest): Promise<ProvisionKeyResult> {
    return this.timed("createKey", () => super.createKey(req));
  }

  override sign(req: SignRequest): Promise<SignResult> {
    return this.timed("sign", () => super.sign(req));
  }

  override reconcile(keyId: string, cloid: string, status: ReconcileStatus): Promise<void> {
    return this.timed("reconcile", () => super.reconcile(keyId, cloid, status));
  }
}
