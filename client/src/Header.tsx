import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FadeIn, PressScale } from './motion';
import { colors, fonts } from './theme';
import type { IconName } from './ui';

export interface HeaderAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  badge?: number;
  /** Заливка чернилами — главное действие экрана */
  primary?: boolean;
}

/** Круглая кнопка-иконка для шапок экранов. */
export function IconButton({ icon, label, onPress, badge, primary }: HeaderAction) {
  return (
    <PressScale
      accessibilityLabel={label}
      onPress={onPress}
      scale={0.92}
      style={{
        width: 42,
        height: 42,
        borderRadius: 21,
        marginLeft: 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: primary ? colors.ink : 'transparent',
      }}
    >
      <Ionicons name={icon} size={20} color={primary ? colors.accentText : colors.text} />
      {badge ? (
        <View
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            paddingHorizontal: 4,
            backgroundColor: colors.accent,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 2,
            borderColor: colors.bg,
          }}
        >
          <Text style={{ color: colors.accentText, fontSize: 10, fontWeight: '700' }}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      ) : null}
    </PressScale>
  );
}

/** Крупная шапка экрана: заголовок, подпись и действия справа. С `back` — кнопка «назад». */
export function Header({
  title,
  subtitle,
  actions = [],
  back,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: HeaderAction[];
  back?: boolean;
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <FadeIn
      distance={6}
      style={{ paddingTop: insets.top + 10, paddingHorizontal: 20, paddingBottom: 8, alignItems: 'center' }}
    >
      <View style={{ width: '100%', maxWidth: 760 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {back ? (
            <View style={{ marginRight: 10, marginLeft: -6 }}>
              <IconButton
                icon="chevron-back"
                label="Назад"
                onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              />
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: colors.text,
                fontSize: 34,
                fontFamily: fonts.serif,
                fontWeight: '400',
                letterSpacing: -0.8,
              }}
              numberOfLines={1}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text style={{ color: colors.muted, fontSize: 14, marginTop: 1 }} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row' }}>
            {actions.map((a) => (
              <IconButton key={a.label} {...a} />
            ))}
          </View>
        </View>
        {children}
      </View>
    </FadeIn>
  );
}
