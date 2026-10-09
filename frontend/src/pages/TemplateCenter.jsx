import { useSearchParams } from 'react-router-dom'
import Templates from './Templates'
import PersonalTemplates from './PersonalTemplates'
export default function TemplateCenter() {
  const [params] = useSearchParams()
  return params.get('source') === 'personal' ? <PersonalTemplates /> : <Templates />
}
