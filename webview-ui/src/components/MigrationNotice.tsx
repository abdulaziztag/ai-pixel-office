import { Button } from './ui/Button.js';

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  return (
    <div
      className="absolute inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onDismiss}
    >
      <div
        className="pixel-panel py-24 px-32 max-w-xl text-center leading-[1.3]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-5xl mb-12 text-accent">Планировка сброшена</div>
        <p className="text-xl m-0 mb-12">
          Офис обновил набор изображений, поэтому прежняя расстановка мебели сброшена к исходной.
        </p>
        <p className="text-xl m-0 mb-12">Извините за неудобство — это разовая история.</p>
        <p className="text-xl m-0 mb-20">Расставить мебель заново можно кнопкой «Планировка».</p>
        <Button variant="accent" size="xl" onClick={onDismiss}>
          Понятно
        </Button>
      </div>
    </div>
  );
}
