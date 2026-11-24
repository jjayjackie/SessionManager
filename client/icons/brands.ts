import type { PluginIcon } from "@getpaseo/plugin/client";
import type { ProviderId } from "../../shared/schema";
import antigravitySvg from "./antigravity.svg";
import claudeSvg from "./claude.svg";
import codexSvg from "./codex.svg";
import sessionManagerSvg from "./session-manager.svg";

/**
 * Official provider brand marks, signature brand colors, and the SessionManager monochrome
 * sidebar/header mark derived from assets/icon.png (stacked session cards + terminal prompt).
 * All non-brand UI colors (surfaces, text, borders, semantic states) come strictly from theme.colors.
 */

export const SESSION_MANAGER_ICON: PluginIcon = { svg: sessionManagerSvg };

export const PROVIDER_BRAND: Record<ProviderId, { icon: PluginIcon; color: string }> = {
  claude: { icon: { svg: claudeSvg }, color: "#D97757" },
  codex: { icon: { svg: codexSvg }, color: "#10A37F" },
  antigravity: { icon: { svg: antigravitySvg }, color: "#4285F4" },
};
