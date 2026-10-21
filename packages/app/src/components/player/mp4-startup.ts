export class Mp4MetadataDeadline {
  private readonly startedAt: number;
  private lastProgressAt: number | null = null;
  constructor(
    private readonly initialMs: number,
    private readonly allowProgressGrace: boolean,
    private readonly now: () => number = () => performance.now(),
  ) { this.startedAt = now(); }
  progress(): void { this.lastProgressAt = this.now(); }
  elapsedMs(): number { return this.now() - this.startedAt; }
  nextWaitMs(): number | null {
    const elapsed = this.elapsedMs();
    if (elapsed < this.initialMs) return this.initialMs - elapsed;
    if (!this.allowProgressGrace || this.lastProgressAt == null ||
        this.now() - this.lastProgressAt > 5000 || elapsed >= 45000) return null;
    return Math.min(3000, 45000 - elapsed);
  }
}

export function handleMp4Failure({
  explicitChoice, failedUrl, onManualFailure, onAutomaticFailure,
}: {
  explicitChoice: { url: string; label: string } | null;
  failedUrl: string;
  onManualFailure: (label: string) => void;
  onAutomaticFailure: () => void;
}): void {
  if (explicitChoice?.url === failedUrl) onManualFailure(explicitChoice.label);
  else onAutomaticFailure();
}
