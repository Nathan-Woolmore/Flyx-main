import type { ContentCategory, ExtractionRequest } from "@flyx/core";
import { PROVIDER_PRIORITIES } from "@flyx/config";
import { extractVidLove } from "@flyx/extractors/services";
import { BaseProvider } from "../base";

export class VidLoveProvider extends BaseProvider {
  readonly name = "vidlove";
  readonly priority = PROVIDER_PRIORITIES.VIDLOVE;
  readonly supportedContent: ContentCategory[] = ["movie", "tv"];

  protected doExtract(request: ExtractionRequest) {
    return extractVidLove(request.tmdbId, request.mediaType, request.season, request.episode);
  }
}
