import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { ProviderId } from "../shared/schema";

/**
 * Clean industrial React Native primitives styled exclusively with Paseo theme tokens.
 * Tight radii (4-6px), hairline borders, uppercase tracked micro-labels, tabular numbers.
 */

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function providerTone(provider: ProviderId): Tone {
  switch (provider) {
    case "claude":
      return "accent";
    case "codex":
      return "success";
    case "antigravity":
      return "warning";
  }
}

export function providerShortLabel(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "CLAUDE";
    case "codex":
      return "CODEX";
    case "antigravity":
      return "AGY";
  }
}

export function useText(theme: PluginTheme) {
  return useMemo(
    () => ({
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      body: { color: theme.colors.foreground, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700" as const, letterSpacing: 0.7, textTransform: "uppercase" as const },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
    }),
    [theme],
  );
}

interface ButtonProps {
  theme: PluginTheme;
  label: string;
  icon?: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  compact?: boolean;
  iconOnly?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({ theme, label, icon, onPress, variant = "secondary", disabled, busy, accessibilityLabel, compact, iconOnly, style }: ButtonProps) {
  const c = theme.colors;
  const foreground = variant === "primary" ? c.accentForeground : variant === "danger" ? c.statusDanger : c.foreground;
  const inactive = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        {
          minHeight: compact ? 28 : 34,
          paddingHorizontal: iconOnly ? (compact ? 6 : 8) : compact ? 10 : 12,
          borderRadius: 5,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          borderWidth: variant === "ghost" ? 0 : 1,
          borderColor: variant === "primary" ? c.accent : variant === "danger" ? c.statusDanger : c.border,
          backgroundColor: variant === "primary" ? c.accent : variant === "ghost" ? "transparent" : c.surface1,
          opacity: inactive ? 0.45 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Icon name={icon} size={compact ? 13 : 15} color={foreground} /> : null}
      {iconOnly ? null : (
        <Text numberOfLines={1} style={{ color: foreground, fontSize: compact ? 12 : 13, fontWeight: "600" }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Checkbox({ theme, checked, mixed, label, onToggle, disabled }: { theme: PluginTheme; checked: boolean; mixed?: boolean; label: string; onToggle(): void; disabled?: boolean }) {
  const c = theme.colors;
  const on = checked || Boolean(mixed);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: mixed && !checked ? "mixed" : checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onToggle}
      hitSlop={10}
      style={{
        width: 16,
        height: 16,
        borderRadius: 3,
        borderWidth: 1.5,
        borderColor: on ? c.accent : c.foregroundMuted,
        backgroundColor: on ? c.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : 1,
      }}
    >
      {on ? <Icon name={checked ? "Check" : "Minus"} size={11} color={c.accentForeground} /> : null}
    </Pressable>
  );
}

export function Badge({ theme, label, tone = "neutral", icon }: { theme: PluginTheme; label: string; tone?: Tone; icon?: string }) {
  const color = toneColor(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        borderWidth: 1,
        borderColor: color,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {icon ? <Icon name={icon} size={10} color={color} /> : null}
      <Text numberOfLines={1} style={{ color, fontSize: 10, fontWeight: "700", letterSpacing: 0.3 }}>
        {label}
      </Text>
    </View>
  );
}

/** Crisp industrial provider indicator tag (`CLAUDE`, `CODEX`, `AGY`). */
export function ProviderTag({ theme, provider, label }: { theme: PluginTheme; provider: ProviderId; label?: string }) {
  const color = toneColor(theme, providerTone(provider));
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderLeftWidth: 2.5,
        borderLeftColor: color,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "700", fontFamily: "monospace", letterSpacing: 0.5 }}>
        {label ?? providerShortLabel(provider)}
      </Text>
    </View>
  );
}

export function ProviderDot({ theme, provider }: { theme: PluginTheme; provider: ProviderId }) {
  return <View style={{ width: 6, height: 6, borderRadius: 2, backgroundColor: toneColor(theme, providerTone(provider)) }} />;
}

export function Banner({ theme, tone, text, action }: { theme: PluginTheme; tone: Tone; text: string; action?: ReactNode }) {
  const color = toneColor(theme, tone);
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: color,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name={tone === "danger" ? "CircleAlert" : tone === "warning" ? "TriangleAlert" : "Info"} size={15} color={color} />
      <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}>{text}</Text>
      {action}
    </View>
  );
}

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

/** A labelled industrial selector that opens a Paseo modal (bottom sheet on compact layouts). */
export function Select<V extends string>({
  theme,
  label,
  value,
  options,
  onChange,
  compact,
  highlighted,
}: {
  theme: PluginTheme;
  label: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange(value: V): void;
  compact?: boolean;
  highlighted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const current = options.find((option) => option.value === value);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? ""}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          minHeight: compact ? 28 : 32,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 8,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: highlighted ? c.accent : c.border,
          backgroundColor: highlighted ? c.surface2 : c.surface1,
          opacity: pressed ? 0.75 : 1,
          maxWidth: 240,
        })}
      >
        <Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{label}</Text>
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
          {current?.label ?? ""}
        </Text>
        <Icon name="ChevronDown" size={13} color={c.foregroundMuted} />
      </Pressable>
      <Modal title={label} open={open} onOpenChange={setOpen}>
        <Modal.Content contentContainerStyle={{ padding: 8, gap: 2 }}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  borderRadius: 5,
                  backgroundColor: active ? c.surface2 : pressed ? c.surface1 : "transparent",
                })}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: active ? "700" : "400" }}>{option.label}</Text>
                  {option.hint ? (
                    <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
                      {option.hint}
                    </Text>
                  ) : null}
                </View>
                {active ? <Icon name="Check" size={15} color={c.accent} /> : null}
              </Pressable>
            );
          })}
        </Modal.Content>
      </Modal>
    </>
  );
}

export function SectionHeader({ theme, title, right }: { theme: PluginTheme; title: string; right?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.7, textTransform: "uppercase" }}>
        {title}
      </Text>
      {right ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>{right}</Text>
      ) : null}
    </View>
  );
}

export function MetricCard({ theme, label, value, tone }: { theme: PluginTheme; label: string; value: string; tone?: Tone }) {
  const c = theme.colors;
  return (
    <View
      style={{
        flex: 1,
        minWidth: 120,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        gap: 3,
      }}
    >
      <Text style={{ color: c.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: tone ? toneColor(theme, tone) : c.foreground, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}

export function Field({ theme, label, children, value, mono }: { theme: PluginTheme; label: string; value?: string; mono?: boolean; children?: ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</Text>
      {value !== undefined ? (
        <Text selectable style={[{ color: theme.colors.foreground, fontSize: 12.5 }, mono ? ({ fontFamily: "monospace", fontSize: 11.5 } as TextStyle) : null]}>
          {value || "—"}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function Divider({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}
