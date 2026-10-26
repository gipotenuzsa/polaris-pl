import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from './theme';

const native = Platform.OS !== 'web';

/** Плавное появление: прозрачность + лёгкий подъём. `delay` даёт каскад в списках. */
export function FadeIn({
  children,
  delay = 0,
  distance = 8,
  duration = 280,
  style,
}: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: native,
    }).start();
  }, [v, delay, duration]);
  return (
    <Animated.View
      style={[
        style,
        { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }] },
      ]}
    >
      {children}
    </Animated.View>
  );
}

const APressable = Animated.createAnimatedComponent(Pressable);

/** Нажатие с лёгким «вдавливанием» вместо мигания прозрачностью. Стиль применяется к самой кнопке (flex и отступы работают). */
export function PressScale({
  children,
  style,
  scale = 0.97,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & { children: ReactNode; style?: StyleProp<ViewStyle>; scale?: number }) {
  const [v] = useState(() => new Animated.Value(1));
  const to = (toValue: number) =>
    Animated.spring(v, { toValue, speed: 40, bounciness: 0, useNativeDriver: native }).start();
  return (
    <APressable
      {...rest}
      onPressIn={(e) => {
        to(scale);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        onPressOut?.(e);
      }}
      style={[style, { transform: [{ scale: v }] }]}
    >
      {children}
    </APressable>
  );
}

function Dot({ index, color, size }: { index: number; color: string; size: number }) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(index * 160),
        Animated.timing(v, { toValue: 1, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(v, { toValue: 0, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.delay((2 - index) * 160),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, index]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        marginHorizontal: size / 3,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -size / 2] }) }],
      }}
    />
  );
}

/** Три пульсирующие точки: «агент думает». */
export function TypingDots({ color = colors.accent, size = 6 }: { color?: string; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: size * 2.5 }}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} index={i} color={color} size={size} />
      ))}
    </View>
  );
}
