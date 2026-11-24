import type { PluginIcon } from "@getpaseo/plugin/client";
import type { ProviderId } from "../../shared/schema";
import antigravitySvg from "./antigravity.svg";
import claudeSvg from "./claude.svg";
import codexSvg from "./codex.svg";

/**
 * Official provider brand marks and signature accent colors.
 * All non-brand UI colors (surfaces, text, borders, semantic states) come strictly from theme.colors.
 */

export const PROVIDER_BRAND: Record<ProviderId, { icon: PluginIcon; color: string }> = {
  claude: { icon: { svg: claudeSvg }, color: "#D97757" },
  codex: { icon: { svg: codexSvg }, color: "#10A37F" },
  antigravity: { icon: { svg: antigravitySvg }, color: "#4285F4" },
};
