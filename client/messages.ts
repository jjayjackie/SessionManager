import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/**
 * Official Paseo plugin translations (Paseo 0.13+). The app's language selects the resource;
 * languages other than Simplified Chinese fall back to English.
 */
export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });
