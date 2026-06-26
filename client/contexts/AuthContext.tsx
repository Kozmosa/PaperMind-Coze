import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface UserOut {
  id: string;
  email?: string;
  phone?: string;
}

interface AuthContextType {
  user: UserOut | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  refreshKey: number;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  updateUser: (userData: Partial<UserOut>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = '@papermind_session';

function getSupabaseConfig() {
  const config = {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
    anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
  };
  return config;
}

function createSupabaseClient(): SupabaseClient | null {
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey || url === 'https://placeholder.supabase.co') {
    return null;
  }
  return createClient(url, anonKey);
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserOut | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // 从 AsyncStorage 恢复 session
    AsyncStorage.getItem(SESSION_KEY).then((stored) => {
      if (stored) {
        try {
          const session = JSON.parse(stored);
          setUser(session.user || null);
          setToken(session.token || null);
        } catch {}
      }
      setIsLoading(false);
    });
  }, []);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        // Fallback: 使用临时用户
        const tempUser = { id: `temp_${Date.now()}`, email };
        const tempToken = `temp_${btoa(email)}`;
        setUser(tempUser);
        setToken(tempToken);
        await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ user: tempUser, token: tempToken }));
        return { success: true };
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { success: false, error: error.message };

      setUser({ id: data.user?.id || '', email: data.user?.email });
      setToken(data.session?.access_token || '');
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({
        user: { id: data.user?.id || '', email: data.user?.email },
        token: data.session?.access_token || '',
      }));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || '登录失败' };
    }
  };

  const signup = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const supabase = createSupabaseClient();
      if (!supabase) {
        return { success: false, error: '认证服务未配置' };
      }

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return { success: false, error: error.message };

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || '注册失败' };
    }
  };

  const logout = async () => {
    try {
      const supabase = createSupabaseClient();
      if (supabase) {
        await supabase.auth.signOut();
      }
    } catch {}
    setUser(null);
    setToken(null);
    setRefreshKey(k => k + 1);
    await AsyncStorage.removeItem(SESSION_KEY);
  };

  const updateUser = (userData: Partial<UserOut>) => {
    setUser((prev) => prev ? { ...prev, ...userData } : null);
  };

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: !!token,
    isLoading,
    refreshKey,
    login,
    signup,
    logout,
    updateUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
