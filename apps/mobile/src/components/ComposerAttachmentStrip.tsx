import { SymbolView } from "../components/AppSymbol";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";
import { AppText as Text } from "./AppText";

import type { DraftComposerAttachment } from "../lib/composerImages";

export interface ComposerAttachmentStripProps {
  /** Attachment images to display. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user taps the remove button on an image. */
  readonly onRemove: (imageId: string) => void;
  /** Called when the user taps on an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

/**
 * A horizontally-scrollable strip of image attachment thumbnails with remove
 * buttons.  Used by both the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const subtleBg = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-foreground");
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View
            key={attachment.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            <Pressable
              onPress={
                attachment.type === "image" && props.onPressImage
                  ? () => props.onPressImage!(attachment.previewUri)
                  : undefined
              }
            >
              {attachment.type === "image" ? (
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: subtleBg,
                  }}
                  resizeMode="cover"
                />
              ) : (
                <View
                  className="items-center justify-center gap-1.5 px-2"
                  style={{
                    width: size * 1.8,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: subtleBg,
                  }}
                >
                  <SymbolView name="doc" size={20} tintColor={iconColor} />
                  <Text className="w-full text-center text-xs" numberOfLines={1}>
                    {attachment.name}
                  </Text>
                </View>
              )}
            </Pressable>
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              onPress={() => props.onRemove(attachment.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
