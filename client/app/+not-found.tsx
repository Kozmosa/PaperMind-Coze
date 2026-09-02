import { View, Text } from 'react-native';
import { Link } from 'expo-router';

export default function NotFoundScreen() {
  return (
    <View className="bg-background flex-1 items-center justify-center">
      <Text className="text-foreground">页面不存在</Text>
      <Link href="/" className="text-accent mt-6">
        返回首页
      </Link>
    </View>
  );
}
