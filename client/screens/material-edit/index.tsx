import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';

const C = {
  bg: '#FFFFFF',
  primary: '#6C63FF',
  text: '#1A1A1A',
  textSecondary: '#8E8E93',
  placeholder: '#C0C0C0',
  border: '#E8E8ED',
  accent: '#FF9F43',
  accentBg: '#FFF8F0',
  chipBg: '#F0EDFF',
};

export default function MaterialViewScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { id } = useSafeSearchParams<{ id: string }>();

  const [viewUrl, setViewUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState('');
  const [papercore, setPapercore] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [logicalPath, setLogicalPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [reprocessing, setReprocessing] = useState(false);
  const [showPapercore, setShowPapercore] = useState(true);
  const [loadError, setLoadError] = useState('');

  const isPDF = fileType === 'PDF';

  useFocusEffect(
    useCallback(() => {
      if (id) loadAll();
      else setLoading(false);
    }, [id])
  );

  const loadAll = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [fileRes, matRes] = await Promise.all([
        api.getMaterialFileContent(id!).catch((e: any) => {
          console.warn('[material-edit] getMaterialFileContent failed:', e?.message || e);
          const status = e?.message?.match?.(/\d+/)?.[0] || '';
          const detail = e?.message?.replace?.(/^API Error: \d+ - /, '') || '';
          return { error: true, message: status === '404' ? '文件不存在于磁盘' : (detail || e?.message || '请求失败') };
        }),
        api.getMaterials().catch(() => ({ data: [] })),
      ]);

      if ((fileRes as any)?.error) {
        setLoadError((fileRes as any).message);
      } else if (fileRes?.data) {
        setViewUrl(fileRes.data.viewUrl || '');
        setFileName(fileRes.data.fileName || '');
        setFileType(fileRes.data.fileType || '');
      } else {
        setLoadError('服务器返回数据异常');
      }

      const material = ((matRes as any)?.data || []).find((m: any) => m.id === id);
      if (material) {
        setPapercore(material.papercore || '');
        setTags(material.tags || []);
        setLogicalPath(material.logical_path || '');
        if (material.ai_processed && !material.viewed_after_process) {
          api.markViewed('material', material.id).catch(() => {});
        }
      }
    } catch (e: any) {
      console.error('[material-edit] loadAll error:', e);
      setLoadError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReprocess = async () => {
    setReprocessing(true);
    try {
      const res = await api.reprocessMaterial(id!);
      const d = (res as any)?.data;
      if (d?.status === 'reprocessed') {
        setPapercore(d.papercore || '');
        setTags(d.tags || []);
        setLogicalPath(d.logical_path || '');
        setShowPapercore(true);
        Alert.alert('完成', 'AI 已重新分析该资料');
      } else {
        Alert.alert('提示', d?.reason || '处理失败');
      }
    } catch (e: any) {
      Alert.alert('错误', e.message || '重新分析失败');
    } finally {
      setReprocessing(false);
    }
  };

  if (loading) {
    return (
      <Screen backgroundColor={C.bg}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={{ color: C.textSecondary, marginTop: 12 }}>加载资料...</Text>
        </View>
      </Screen>
    );
  }

  if (!id) {
    return (
      <Screen backgroundColor={C.bg}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
          <Feather name="alert-circle" size={48} color={C.placeholder} />
          <Text style={{ fontSize: 16, color: C.textSecondary, marginTop: 16, textAlign: 'center' }}>
            无法加载资料
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen backgroundColor={C.bg} safeAreaEdges={['left', 'right', 'bottom']}>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {/* ======== Header ======== */}
        <View style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 16,
          paddingBottom: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <TouchableOpacity onPress={() => router.back()} style={{ padding: 6 }}>
            <Feather name="arrow-left" size={22} color={C.text} />
          </TouchableOpacity>

          <View style={{ flex: 1, marginHorizontal: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }} numberOfLines={1}>
              {fileName || '资料'}
            </Text>
            {fileType ? (
              <Text style={{ fontSize: 11, color: C.textSecondary }}>{fileType} 文件</Text>
            ) : null}
          </View>

          <TouchableOpacity
            onPress={handleReprocess}
            disabled={reprocessing}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 14,
              backgroundColor: C.chipBg,
              borderWidth: 1,
              borderColor: C.primary,
            }}
          >
            {reprocessing ? (
              <ActivityIndicator size="small" color={C.primary} />
            ) : (
              <Feather name="refresh-cw" size={12} color={C.primary} />
            )}
            <Text style={{ fontSize: 11, fontWeight: '600', color: C.primary }}>
              {reprocessing ? '分析中' : '重新分析'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ======== PDF Viewer / Unsupported notice ======== */}
        <View style={{ flex: 1 }}>
          {isPDF && viewUrl ? (
            <PDFViewer url={viewUrl} />
          ) : (
            <View style={{
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
              padding: 40,
            }}>
              <Feather name="file-text" size={48} color={C.placeholder} />
              <Text style={{ fontSize: 14, color: C.textSecondary, marginTop: 12, textAlign: 'center' }}>
                {viewUrl
                  ? `${fileType} 文件暂不支持在线预览`
                  : loadError || '文件未找到，无法预览'}
              </Text>
              <Text style={{ fontSize: 12, color: C.placeholder, marginTop: 4, textAlign: 'center' }}>
                {viewUrl
                  ? '该文件格式需要下载后在本地应用中查看'
                  : (loadError ? '请确认文件已正确上传，或点击重试' : '请确认文件已正确上传')}
              </Text>
              {!viewUrl && loadError ? (
                <TouchableOpacity
                  onPress={loadAll}
                  style={{
                    marginTop: 20,
                    paddingHorizontal: 24,
                    paddingVertical: 10,
                    borderRadius: 10,
                    backgroundColor: C.primary,
                  }}
                >
                  <Text style={{ color: '#FFF', fontWeight: '600', fontSize: 14 }}>重试</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
        </View>

        {/* ======== Fixed Bottom Bar ======== */}
        <View style={{
          borderTopWidth: 1,
          borderTopColor: C.border,
          backgroundColor: C.bg,
          paddingBottom: insets.bottom + 8,
          maxHeight: '45%',
        }}>
          {papercore ? (
            <View>
              <TouchableOpacity
                onPress={() => setShowPapercore(!showPapercore)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 20,
                  paddingVertical: 10,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 3, height: 16, borderRadius: 2, backgroundColor: C.accent }} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: C.accent }}>
                    Papercore 摘要
                  </Text>
                </View>
                <Feather
                  name={showPapercore ? 'chevron-down' : 'chevron-up'}
                  size={16}
                  color={C.accent}
                />
              </TouchableOpacity>

              {showPapercore && (
                <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
                  <Text style={{
                    fontSize: 13,
                    color: C.text,
                    lineHeight: 20,
                    backgroundColor: C.accentBg,
                    borderRadius: 8,
                    padding: 12,
                    overflow: 'hidden',
                  }}>
                    {papercore}
                  </Text>
                </View>
              )}
            </View>
          ) : (
            <View style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
              <Text style={{ fontSize: 12, color: C.placeholder, fontStyle: 'italic' }}>
                暂无 AI 摘要，点击右上角"重新分析"生成
              </Text>
            </View>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {tags.map((tag, i) => {
                  const levelColors = [
                    { bg: '#6C63FF', fg: '#FFF' },
                    { bg: 'rgba(108,99,255,0.15)', fg: '#6C63FF' },
                    { bg: 'rgba(108,99,255,0.06)', fg: '#8B83FF' },
                  ];
                  const lc = levelColors[Math.min(i, 2)];
                  return (
                    <View key={i} style={{
                      backgroundColor: lc.bg,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 8,
                    }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: lc.fg }}>
                        {['📐 ', '📂 ', '📌 '][Math.min(i, 2)]}{tag}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Logical path */}
          {logicalPath ? (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 20,
              paddingBottom: 4,
              gap: 6,
            }}>
              <Feather name="folder" size={12} color={C.accent} />
              <Text style={{ fontSize: 11, color: C.accent }}>{logicalPath}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Screen>
  );
}

// ========== PDF Viewer Component ==========
function PDFViewer({ url }: { url: string }) {
  const [loadError, setLoadError] = useState(false);
  const encodedUrl = encodeURIComponent(url);
  const googleViewerUrl = `https://docs.google.com/viewer?url=${encodedUrl}&embedded=true`;

  if (Platform.OS === 'web') {
    return (
      <iframe
        src={loadError ? googleViewerUrl : url}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
        }}
        title="PDF Viewer"
      />
    );
  }

  // Native: use WebView
  try {
    const WebView = require('react-native-webview').WebView;

    return (
      <WebView
        key={loadError ? 'fallback' : 'direct'}
        source={{ uri: loadError ? googleViewerUrl : url }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowUniversalAccessFromFileURLs={true}
        mixedContentMode="always"
        startInLoadingState={true}
        renderLoading={() => (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={C.primary} />
            <Text style={{ color: C.textSecondary, marginTop: 8 }}>加载 PDF...</Text>
          </View>
        )}
        renderError={(errorName: string) => (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
            <Feather name="alert-triangle" size={48} color={C.placeholder} />
            <Text style={{ fontSize: 14, color: C.textSecondary, marginTop: 12, textAlign: 'center' }}>
              PDF 加载失败
            </Text>
            <Text style={{ fontSize: 12, color: C.placeholder, marginTop: 4 }}>
              {errorName}
            </Text>
            <TouchableOpacity
              onPress={() => setLoadError(true)}
              style={{
                marginTop: 16,
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: C.primary,
              }}
            >
              <Text style={{ color: '#FFF', fontWeight: '600', fontSize: 14 }}>
                尝试 Google 云端查看
              </Text>
            </TouchableOpacity>
          </View>
        )}
        onError={() => setLoadError(true)}
      />
    );
  } catch {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
        <Feather name="file" size={48} color={C.placeholder} />
        <Text style={{ fontSize: 14, color: C.textSecondary, marginTop: 12, textAlign: 'center' }}>
          PDF 预览需要 WebView 支持
        </Text>
      </View>
    );
  }
}
