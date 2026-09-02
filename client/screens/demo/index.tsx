import { View, Text } from 'react-native';
import { Image } from 'expo-image';

import { Screen } from '@/components/layout/Screen';

export default function DemoPage() {
  return (
    <Screen statusBarStyle="auto">
      <View className="absolute top-0 left-0 flex h-full w-full flex-col items-center justify-center">
        <Image
          className="h-[109px] w-[130px]"
          source="https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/expo/coze-loading.gif"
        />
        <Text className="text-foreground text-base font-bold">APP 开发中</Text>
        <Text className="text-muted mt-2 text-sm">即将为您呈现应用界面</Text>
      </View>
    </Screen>
  );
}
