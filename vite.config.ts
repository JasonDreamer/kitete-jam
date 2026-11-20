import {defineConfig} from 'vite'

// GitHub Pages などのサブパスに置いても動くよう相対パスで出力する
export default defineConfig({
  base: './'
})
