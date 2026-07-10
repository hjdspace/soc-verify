import { exposeElectronTRPC } from 'electron-trpc/main';

// electron-trpc 要求在 'loaded' 事件后暴露桥接
process.once('loaded', async () => {
  exposeElectronTRPC();
});
