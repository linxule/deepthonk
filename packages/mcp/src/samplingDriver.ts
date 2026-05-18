import { ProviderError, type CompareInput, type FinalizeInput, type GenerateInput, type ModelDriver, type ModelTextResult, type MutateInput } from "@deepthonk/core";

export class SamplingDriver implements ModelDriver {
  async generate(_input: GenerateInput): Promise<ModelTextResult> {
    return this.unsupported();
  }

  async compare(_input: CompareInput): Promise<ModelTextResult> {
    return this.unsupported();
  }

  async mutate(_input: MutateInput): Promise<ModelTextResult> {
    return this.unsupported();
  }

  async finalize(_input: FinalizeInput): Promise<ModelTextResult> {
    return this.unsupported();
  }

  private unsupported(): never {
    throw new ProviderError("MCP Sampling is optional and must be negotiated by the host. Direct provider mode is available.");
  }
}

