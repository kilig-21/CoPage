import { forwardRef } from 'react'
import { ConfigProvider, Input } from 'antd'
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons'

function VisibilityButton({ onClick, ...props }) {
  return <button {...props} onClick={event => {
    // 原输入框的点击处理会重新聚焦正文；键盘切换应留在当前按钮。
    if (event.detail === 0) event.stopPropagation()
    onClick?.(event)
  }} />
}

const PasswordInput = forwardRef(function PasswordInput({ visibilityLabel = '密码', ...props }, ref) {
  const { componentDisabled } = ConfigProvider.useConfig()
  const disabled = props.disabled ?? componentDisabled
  return <Input.Password {...props} ref={ref} iconRender={visible => (
    <VisibilityButton type="button" data-password-toggle="true" disabled={disabled}
      aria-label={`${visible ? '隐藏' : '显示'}${visibilityLabel}`} aria-controls={props.id}>
      {visible ? <EyeOutlined aria-hidden="true" /> : <EyeInvisibleOutlined aria-hidden="true" />}
    </VisibilityButton>
  )} />
})

export default PasswordInput
