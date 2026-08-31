import {
  fingerprintRuntimeHome,
  parseRuntimeHostControlSnapshot,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type RuntimeHostControlPlane,
  type RuntimeHostControlState,
} from "../packages/core/src/runtime/host-contract.js";

export interface RuntimeControlHost {
  snapshot(): {
    readonly state: string;
    readonly ready: boolean;
    readonly accepting?: boolean;
    readonly generation: number;
  };
}

export function createRuntimeControlPlane(input: {
  readonly runtimeHome: string;
  readonly ownerId: string;
  readonly host: RuntimeControlHost;
}): RuntimeHostControlPlane {
  const homeFingerprint = fingerprintRuntimeHome(input.runtimeHome);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ownerId) ||
      typeof input.host?.snapshot !== "function") {
    throw new Error("Runtime control plane configuration is invalid");
  }
  return Object.freeze({
    snapshot() {
      const host = input.host.snapshot();
      return parseRuntimeHostControlSnapshot({
        protocolVersion: RUNTIME_HOST_PROTOCOL_VERSION,
        ownerId: input.ownerId,
        homeFingerprint,
        generation: host.generation,
        state: host.state as RuntimeHostControlState,
        ready: host.ready,
        accepting: host.accepting === true,
        workerOwner: true,
      });
    },
  });
}
