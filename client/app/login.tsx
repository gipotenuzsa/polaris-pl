import { FadeIn } from '../src/motion';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getBaseUrl, needsServerUrl } from '../src/api';
import { useAuth } from '../src/auth';
import { colors, space } from '../src/theme';
import { Button, ErrorNote, Input, Muted } from '../src/ui';

export default function Login() {
  const { signIn } = useAuth();
  const [url, setUrl] = useState(getBaseUrl());
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askUrl = needsServerUrl();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(url, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}>
            <FadeIn style={{ alignItems: 'center', marginBottom: space.xl * 1.5 }} distance={14} duration={500}>
              <Text style={{ color: colors.accent, fontSize: 44 }}>✦</Text>
              <Text style={{ color: colors.text, fontSize: 34, fontWeight: '600', letterSpacing: -1, marginTop: space.sm }}>
                Polaris
              </Text>
              <Muted style={{ marginTop: 4 }}>Личный фоновый AI-агент</Muted>
            </FadeIn>
            <ErrorNote message={error} />
            {askUrl ? (
              <Input
                label="Адрес сервера"
                value={url}
                onChangeText={setUrl}
                placeholder="https://polaris-xxxx.onrender.com"
                keyboardType="url"
              />
            ) : null}
            <Input
              label="Пароль инстанса"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="Пароль"
              onSubmitEditing={submit}
              returnKeyType="go"
            />
            <Button title="Войти" onPress={submit} loading={busy} disabled={!password} />
            <Muted style={{ marginTop: space.lg, textAlign: 'center' }}>
              Если сервер на бесплатном Render «спал», первый вход может занять около минуты.
            </Muted>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
