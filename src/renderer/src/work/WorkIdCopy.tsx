import { Check, Copy } from "@phosphor-icons/react"
import { type JSX, useState } from "react"
import { Button } from "../ui/Button.js"

export function WorkIdCopy({ id }: { readonly id: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Button variant="quiet" className="inline-flex items-center gap-1" onClick={copy} title="Copy work id">
      <span>{id}</span>
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
    </Button>
  )
}
