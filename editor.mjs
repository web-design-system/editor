import { defineEvent, defineProp, ref } from '@li3/web';

export default function () {
  const team = defineProp('team', { default: 'web-design-system' });
  const component = defineProp('component', { default: 'editor' });
  const revision = defineProp('revision', { default: 'latest' });
  const source = ref('<template component="wds-editor">\n  <!-- HTML-first component source -->\n</template>');
  const activeFile = ref('component.html');
  const viewport = ref(1024);
  const status = ref('Draft loaded locally');
  const onCommit = defineEvent('commit');
  const onCreateComponent = defineEvent('createcomponent');

  function updateSource(event) {
    source.value = event.target.value;
    status.value = 'Unsaved changes';
  }

  function setViewport(event) {
    viewport.value = Number(event.target.value);
  }

  function commit() {
    status.value = 'Committed to latest';
    onCommit({ file: activeFile.value, source: source.value });
  }

  function createComponent() {
    onCreateComponent();
  }

  return { team, component, revision, source, activeFile, viewport, status, updateSource, setViewport, commit, createComponent };
}
