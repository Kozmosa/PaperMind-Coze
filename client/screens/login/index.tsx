import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { useState } from 'react';
import { Screen } from '@/components/Screen';
import { useAuth } from '@/contexts/AuthContext';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const router = useSafeRouter();

  const handleLogin = async () => {
    if (!email.trim()) {
      setError('请输入邮箱');
      return;
    }
    if (!password.trim()) {
      setError('请输入密码');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const result = await login(email.trim(), password);
      if (result.success) {
        router.replace('/(tabs)');
      } else {
        setError(result.error || '登录失败');
      }
    } catch (err: any) {
      setError(err.message || '登录失败，请检查邮箱和密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <LinearGradient
        colors={['#6C63FF', '#8B5CF6']}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
          {/* Logo Area */}
          <View style={{ alignItems: 'center', marginBottom: 48 }}>
            <View style={{
              width: 80, height: 80, borderRadius: 20,
              backgroundColor: 'rgba(255,255,255,0.2)',
              justifyContent: 'center', alignItems: 'center',
              marginBottom: 16,
            }}>
              <Feather name="book-open" size={40} color="#fff" />
            </View>
            <Text style={{ fontSize: 28, fontWeight: 'bold', color: '#fff' }}>PaperMind</Text>
            <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 8 }}>
              知识管理 · AI 导师 · 学习追踪
            </Text>
          </View>

          {/* Login Form */}
          <View style={{
            width: '100%',
            backgroundColor: '#fff',
            borderRadius: 24,
            padding: 24,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.15,
            shadowRadius: 16,
            elevation: 8,
          }}>
            <Text style={{ fontSize: 20, fontWeight: '600', color: '#1a1a2e', marginBottom: 20 }}>
              登录账号
            </Text>

            <Text style={{ fontSize: 13, color: '#6B7280', marginBottom: 6 }}>邮箱</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="请输入邮箱"
              placeholderTextColor="#9CA3AF"
              keyboardType="email-address"
              autoCapitalize="none"
              style={{
                height: 48,
                borderWidth: 1,
                borderColor: '#E5E7EB',
                borderRadius: 12,
                paddingHorizontal: 16,
                fontSize: 15,
                color: '#1a1a2e',
                marginBottom: 16,
                backgroundColor: '#F9FAFB',
              }}
            />

            <Text style={{ fontSize: 13, color: '#6B7280', marginBottom: 6 }}>密码</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="请输入密码"
              placeholderTextColor="#9CA3AF"
              secureTextEntry
              style={{
                height: 48,
                borderWidth: 1,
                borderColor: '#E5E7EB',
                borderRadius: 12,
                paddingHorizontal: 16,
                fontSize: 15,
                color: '#1a1a2e',
                marginBottom: 8,
                backgroundColor: '#F9FAFB',
              }}
            />

            {error ? (
              <Text style={{ fontSize: 13, color: '#EF4444', marginBottom: 16 }}>{error}</Text>
            ) : null}

            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading}
              style={{
                height: 48,
                borderRadius: 12,
                backgroundColor: '#6C63FF',
                justifyContent: 'center',
                alignItems: 'center',
                marginTop: 8,
              }}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>登录</Text>
              )}
            </TouchableOpacity>

            <Text style={{ fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 16 }}>
              演示模式：任意邮箱密码即可登录
            </Text>
          </View>
        </View>
      </LinearGradient>
    </Screen>
  );
}
