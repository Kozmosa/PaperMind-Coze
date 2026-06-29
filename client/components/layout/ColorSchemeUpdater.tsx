import { Fragment, useEffect, type ReactNode } from 'react';
import { Uniwind } from 'uniwind'

// Force light theme — do not follow system or workbench color scheme
const DEFAULT_THEME: 'system' | 'light' | 'dark' = 'light'

const WebOnlyColorSchemeUpdater = function ({ children }: { children?: ReactNode }) {
  useEffect(() => {
    Uniwind.setTheme(DEFAULT_THEME);
  }, []);

  return <Fragment>
    {children}
  </Fragment>
};

export {
  WebOnlyColorSchemeUpdater,
}
